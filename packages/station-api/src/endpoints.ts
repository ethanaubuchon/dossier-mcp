import type { z } from 'zod';
import {
  BulkUpdateIssuesRequestSchema,
  BulkUpdateIssuesResponseSchema,
  CommentIssueRequestSchema,
  CreateIssueRequestSchema,
  CreateIssueResponseSchema,
  IssueWriteResponseSchema,
  QueryIssuesRequestSchema,
  QueryIssuesResponseSchema,
  UpdateIssueRequestSchema,
} from './issues.js';
import {
  FreshenRequestSchema,
  FreshenResponseSchema,
  GetNoteRequestSchema,
  GetNoteResponseSchema,
  HistoryRequestSchema,
  HistoryResponseSchema,
  ListNotesRequestSchema,
  ListNotesResponseSchema,
  PromoteRequestSchema,
  ProposeRequestSchema,
  ResolveRequestSchema,
  SearchNotesRequestSchema,
  SearchNotesResponseSchema,
  WriteRequestSchema,
  WriteResponseSchema,
} from './notes.js';

/** API key scope an endpoint requires. A `read-write` key satisfies `read`. */
export type KeyScope = 'read' | 'read-write';

export interface EndpointDef {
  path: string;
  summary: string;
  scope: KeyScope;
  request: z.ZodType;
  /** `null` for reserved verbs, which only ever answer `not_implemented`. */
  response: z.ZodType | null;
}

/**
 * The whole HTTP surface. Every endpoint is a `POST` with a JSON body; slugs
 * contain `/`, so they travel in the body rather than the path. The client
 * methods and the OpenAPI paths are both derived from this table.
 */
export const endpoints = {
  getNote: {
    path: '/api/v1/notes/get',
    summary: 'Read one note',
    scope: 'read',
    request: GetNoteRequestSchema,
    response: GetNoteResponseSchema,
  },
  listNotes: {
    path: '/api/v1/notes/list',
    summary: 'List notes, optionally under a slug prefix',
    scope: 'read',
    request: ListNotesRequestSchema,
    response: ListNotesResponseSchema,
  },
  searchNotes: {
    path: '/api/v1/notes/search',
    summary: 'Full-text search over issues and docs',
    scope: 'read',
    request: SearchNotesRequestSchema,
    response: SearchNotesResponseSchema,
  },
  write: {
    path: '/api/v1/write',
    summary: 'Write a doc directly',
    scope: 'read-write',
    request: WriteRequestSchema,
    response: WriteResponseSchema,
  },
  history: {
    path: '/api/v1/history',
    summary: 'Commit history of one note',
    scope: 'read',
    request: HistoryRequestSchema,
    response: HistoryResponseSchema,
  },
  freshen: {
    path: '/api/v1/freshen',
    summary: 'Bring the caller\'s view up to date (no-op)',
    scope: 'read',
    request: FreshenRequestSchema,
    response: FreshenResponseSchema,
  },
  propose: {
    path: '/api/v1/propose',
    summary: 'Propose a gated change (reserved)',
    scope: 'read-write',
    request: ProposeRequestSchema,
    response: null,
  },
  resolve: {
    path: '/api/v1/resolve',
    summary: 'Accept or reject a proposal (reserved)',
    scope: 'read-write',
    request: ResolveRequestSchema,
    response: null,
  },
  promote: {
    path: '/api/v1/promote',
    summary: 'Publish a doc into the station (reserved)',
    scope: 'read-write',
    request: PromoteRequestSchema,
    response: null,
  },
  createIssue: {
    path: '/api/v1/issues/create',
    summary: 'Create an issue, with a duplicate check',
    scope: 'read-write',
    request: CreateIssueRequestSchema,
    response: CreateIssueResponseSchema,
  },
  updateIssue: {
    path: '/api/v1/issues/update',
    summary: 'Change an issue\'s fields or status',
    scope: 'read-write',
    request: UpdateIssueRequestSchema,
    response: IssueWriteResponseSchema,
  },
  commentIssue: {
    path: '/api/v1/issues/comment',
    summary: 'Comment on an issue',
    scope: 'read-write',
    request: CommentIssueRequestSchema,
    response: IssueWriteResponseSchema,
  },
  queryIssues: {
    path: '/api/v1/issues/query',
    summary: 'Find issues by status, project, repo, label or staleness',
    scope: 'read',
    request: QueryIssuesRequestSchema,
    response: QueryIssuesResponseSchema,
  },
  bulkUpdateIssues: {
    path: '/api/v1/issues/bulk-update',
    summary: 'Apply several issue updates',
    scope: 'read-write',
    request: BulkUpdateIssuesRequestSchema,
    response: BulkUpdateIssuesResponseSchema,
  },
} as const satisfies Record<string, EndpointDef>;

export type Endpoints = typeof endpoints;
export type EndpointName = keyof Endpoints;
