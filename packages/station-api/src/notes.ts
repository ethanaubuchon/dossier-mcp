import { z } from 'zod';
import { CommitShaSchema, IsoDateTimeSchema, SlugSchema } from './common.js';
import { IssueStatusSchema } from './frontmatter.js';
import { named } from './registry.js';

/**
 * Note frontmatter as stored. Station notes include issues and projects, whose
 * frontmatter carries lists and objects, so values are left untyped here; use
 * IssueFrontmatterSchema or ProjectFrontmatterSchema to narrow.
 */
export const NoteFrontmatterSchema = named('NoteFrontmatter', z.record(z.string(), z.unknown()));

export const NoteKindSchema = named(
  'NoteKind',
  z.enum(['issue', 'doc']),
  '`issue` is a note under `issues/`; `doc` is every other note, projects included.',
);

export const NoteSchema = named(
  'Note',
  z.object({
    slug: SlugSchema,
    frontmatter: NoteFrontmatterSchema,
    body: z.string(),
  }),
);

export const NoteListItemSchema = named(
  'NoteListItem',
  z.object({
    slug: SlugSchema,
    frontmatter: NoteFrontmatterSchema,
  }),
);

const excludeTags = z
  .array(z.string())
  .optional()
  .describe('Tags to exclude. Omit for the station default set; `[]` excludes nothing.');

// Reads

export const GetNoteRequestSchema = named('GetNoteRequest', z.object({ slug: SlugSchema }));
export const GetNoteResponseSchema = named('GetNoteResponse', z.object({ note: NoteSchema }));

export const ListNotesRequestSchema = named(
  'ListNotesRequest',
  z.object({
    path: z.string().optional().describe('Slug prefix to list under, e.g. `projects/`.'),
    kind: NoteKindSchema.optional(),
    exclude_tags: excludeTags,
  }),
);
export const ListNotesResponseSchema = named(
  'ListNotesResponse',
  z.object({ notes: z.array(NoteListItemSchema).describe('Newest first.') }),
);

export const SearchNotesRequestSchema = named(
  'SearchNotesRequest',
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    kind: NoteKindSchema.optional().describe('Restrict to issues or docs; omit for both.'),
    exclude_tags: excludeTags,
  }),
);
export const SearchResultSchema = named(
  'SearchResult',
  z.object({
    slug: SlugSchema,
    frontmatter: NoteFrontmatterSchema,
    score: z.number().describe('Raw BM25 score; comparable only within one station.'),
    excerpt: z.string(),
  }),
);
export const SearchNotesResponseSchema = named(
  'SearchNotesResponse',
  z.object({ results: z.array(SearchResultSchema).describe('Highest score first.') }),
);

// Verbs

export const WriteRequestSchema = named(
  'WriteRequest',
  z.object({
    slug: SlugSchema,
    body: z.string(),
    frontmatter: NoteFrontmatterSchema.optional().describe('Replaces the stored frontmatter when given.'),
    create_only: z.boolean().optional().describe('Fail with `conflict` if the note already exists.'),
    message: z.string().optional().describe('Commit message; the station generates one when omitted.'),
  }),
  'Direct (trunk-tier) write of one doc. Issues are written through the issue operations, not this verb.',
);
export const WriteResponseSchema = named(
  'WriteResponse',
  z.object({
    slug: SlugSchema,
    commit: CommitShaSchema,
    created: z.boolean().describe('True when the write created the note.'),
  }),
);

export const HistoryRequestSchema = named(
  'HistoryRequest',
  z.object({
    slug: SlugSchema,
    limit: z.number().int().min(1).optional(),
  }),
);
export const HistoryEntrySchema = named(
  'HistoryEntry',
  z.object({
    commit: CommitShaSchema,
    date: IsoDateTimeSchema,
    author: z.string(),
    message: z.string(),
    status_change: z
      .object({ from: IssueStatusSchema.nullable(), to: IssueStatusSchema })
      .optional()
      .describe('Parsed from the commit\'s `Status:` trailer; `from` is null on creation.'),
  }),
);
export const HistoryResponseSchema = named(
  'HistoryResponse',
  z.object({ entries: z.array(HistoryEntrySchema).describe('Newest first.') }),
);

export const FreshenRequestSchema = named('FreshenRequest', z.object({}));
export const FreshenResponseSchema = named(
  'FreshenResponse',
  z.object({ current: z.literal(true) }),
  'The station is the single source of truth, so the caller\'s view is always current.',
);

/** `propose`, `resolve` and `promote` are reserved: the station answers `not_implemented` until review flows land. */
export const ProposeRequestSchema = named(
  'ProposeRequest',
  z.object({
    slug: SlugSchema,
    body: z.string(),
    frontmatter: NoteFrontmatterSchema.optional(),
    message: z.string().optional(),
  }),
  'Gated change awaiting review. Provisional; always answered with `not_implemented`.',
);

export const ResolveRequestSchema = named(
  'ResolveRequest',
  z.object({
    slug: SlugSchema,
    proposal: z.string().min(1),
    decision: z.enum(['accept', 'reject']),
  }),
  'Accept or reject a proposal. Provisional; always answered with `not_implemented`.',
);

export const PromoteRequestSchema = named(
  'PromoteRequest',
  z.object({
    slug: SlugSchema,
    body: z.string(),
    frontmatter: NoteFrontmatterSchema.optional(),
  }),
  'Cross-vault publish of a doc into the station. Provisional; always answered with `not_implemented`.',
);

export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;
export type NoteKind = z.infer<typeof NoteKindSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type NoteListItem = z.infer<typeof NoteListItemSchema>;
export type GetNoteRequest = z.infer<typeof GetNoteRequestSchema>;
export type GetNoteResponse = z.infer<typeof GetNoteResponseSchema>;
export type ListNotesRequest = z.infer<typeof ListNotesRequestSchema>;
export type ListNotesResponse = z.infer<typeof ListNotesResponseSchema>;
export type SearchNotesRequest = z.infer<typeof SearchNotesRequestSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchNotesResponse = z.infer<typeof SearchNotesResponseSchema>;
export type WriteRequest = z.infer<typeof WriteRequestSchema>;
export type WriteResponse = z.infer<typeof WriteResponseSchema>;
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
export type FreshenRequest = z.infer<typeof FreshenRequestSchema>;
export type FreshenResponse = z.infer<typeof FreshenResponseSchema>;
export type ProposeRequest = z.infer<typeof ProposeRequestSchema>;
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;
