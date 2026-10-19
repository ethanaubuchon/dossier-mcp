import {
  CreateIssueResponseSchema,
  IssueFieldsUpdateSchema,
  IssueFrontmatterSchema,
  IssueIdSchema,
  ProjectFrontmatterSchema,
  SlugSchema,
  type IssueFrontmatter,
} from '../index.js';

const validIssue: IssueFrontmatter = {
  id: 'STN-142',
  type: 'issue',
  title: 'Add ES role',
  status: 'triage',
  created: '2026-10-18T14:02',
  'created-by': { kind: 'agent', source: 'claude-code / home-ansible session' },
  project: 'app-search',
  repos: ['home-ansible'],
  labels: [],
  'blocked-by': ['STN-140'],
  'found-during': 'STN-120',
  owner: 'ethan',
  'last-reviewed': '2026-10-18',
  prs: [],
  origin: 'ethanaubuchon/home-ansible#142',
};

describe('IssueIdSchema', () => {
  it.each(['STN-1', 'STN-142', 'A-9', 'ABCDEFGHIJ-10'])('accepts %s', (id) => {
    expect(IssueIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(['stn-1', 'STN-01', 'STN-0', 'ABCDEFGHIJK-1', 'ST1-4', 'STN142', 'STN-'])('rejects %s', (id) => {
    expect(IssueIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('SlugSchema', () => {
  it.each(['projects/app-search', 'issues/STN-1'.toLowerCase(), 'a', 'docs/v1.2/notes_x'])('accepts %s', (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['', '/abs', 'trailing/', 'a//b', '../up', 'Upper'])('rejects %j', (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(false);
  });
});

describe('IssueFrontmatterSchema', () => {
  it('accepts a fully populated issue', () => {
    expect(IssueFrontmatterSchema.parse(validIssue)).toEqual(validIssue);
  });

  it('accepts a minimal issue', () => {
    const minimal = {
      id: 'STN-1',
      type: 'issue',
      title: 't',
      status: 'backlog',
      created: '2026-10-18T14:02:00Z',
      'created-by': { kind: 'human' },
      repos: [],
      labels: [],
      'blocked-by': [],
      prs: [],
    };
    expect(IssueFrontmatterSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(IssueFrontmatterSchema.safeParse({ ...validIssue, status: 'open' }).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { created: _created, ...rest } = validIssue;
    expect(IssueFrontmatterSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects resolution on an issue that is not canceled', () => {
    const result = IssueFrontmatterSchema.safeParse({ ...validIssue, status: 'done', resolution: 'obsolete' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['resolution']);
  });

  it('accepts a canceled duplicate pointing at the original', () => {
    const fm = { ...validIssue, status: 'canceled', resolution: 'duplicate', 'duplicate-of': 'STN-99' };
    expect(IssueFrontmatterSchema.safeParse(fm).success).toBe(true);
  });

  it('rejects duplicate-of without resolution duplicate', () => {
    const fm = { ...validIssue, status: 'canceled', resolution: 'wont-do', 'duplicate-of': 'STN-99' };
    const result = IssueFrontmatterSchema.safeParse(fm);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['duplicate-of']);
  });
});

describe('IssueFieldsUpdateSchema', () => {
  it('allows null to clear optional fields', () => {
    expect(IssueFieldsUpdateSchema.safeParse({ project: null, owner: null, resolution: null }).success).toBe(true);
  });

  it('does not accept null for required fields', () => {
    expect(IssueFieldsUpdateSchema.safeParse({ title: null }).success).toBe(false);
  });

  it('strips fields fixed at creation', () => {
    const parsed = IssueFieldsUpdateSchema.parse({ status: 'done', id: 'STN-2', created: '2026-01-01T00:00' });
    expect(parsed).toEqual({ status: 'done' });
  });
});

describe('ProjectFrontmatterSchema', () => {
  it('accepts a root project and a nested one', () => {
    expect(ProjectFrontmatterSchema.safeParse({ type: 'project', title: 'Dossier suite' }).success).toBe(true);
    expect(
      ProjectFrontmatterSchema.safeParse({ type: 'project', title: 'Station', parent: 'dossier-suite' }).success,
    ).toBe(true);
  });

  it('rejects an issue-typed note', () => {
    expect(ProjectFrontmatterSchema.safeParse({ type: 'issue', title: 'x' }).success).toBe(false);
  });
});

describe('CreateIssueResponseSchema', () => {
  const candidate = { id: 'STN-3', title: 'Similar', status: 'backlog', score: 4.2 };

  it('discriminates a created issue', () => {
    const parsed = CreateIssueResponseSchema.parse({
      result: 'created',
      issue: { frontmatter: validIssue, body: 'text' },
      commit: 'abc1234',
    });
    expect(parsed.result).toBe('created');
  });

  it('discriminates possible duplicates', () => {
    const parsed = CreateIssueResponseSchema.parse({ result: 'possible-duplicates', candidates: [candidate] });
    expect(parsed.result === 'possible-duplicates' && parsed.candidates).toHaveLength(1);
  });

  it('caps candidates at five and requires at least one', () => {
    const six = Array.from({ length: 6 }, () => candidate);
    expect(CreateIssueResponseSchema.safeParse({ result: 'possible-duplicates', candidates: six }).success).toBe(false);
    expect(CreateIssueResponseSchema.safeParse({ result: 'possible-duplicates', candidates: [] }).success).toBe(false);
  });
});
