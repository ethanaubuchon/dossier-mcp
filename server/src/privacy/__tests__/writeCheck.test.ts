import {
  CHUNK_TOKENS,
  MAX_VERBATIM_MATCHES,
  checkOutgoing,
  collectStrings,
  holdToken,
  normalizeTokens,
  referencedSlugs,
  type PersonalSource,
} from '../writeCheck.js';

const PROFILE =
  'Ethan prefers to lead with the conclusion and one example, and disengages from repetitive work regardless of skill level.';

const sources: PersonalSource[] = [
  { vault: 'personal', slug: 'profile', label: 'profile.md (vault context)', text: PROFILE },
  { vault: 'personal', slug: 'finances/budget', text: 'Budget\nMonthly spend tracked against the savings target for the house fund.' },
];

const out = (...texts: string[]) => ({ texts, links: [] as string[] });

describe('normalizeTokens', () => {
  test('ignores case, punctuation, markdown emphasis and whitespace', () => {
    expect(normalizeTokens('**Lead**  with the\n_conclusion_, then — one `example`!')).toEqual([
      'lead', 'with', 'the', 'conclusion', 'then', 'one', 'example',
    ]);
  });

  test('applies NFKC, so compatibility characters match their plain forms', () => {
    expect(normalizeTokens('ｆｕｌｌｗｉｄｔｈ ﬁle')).toEqual(['fullwidth', 'file']);
  });

  test('keeps letters and digits from any script', () => {
    expect(normalizeTokens('café 2026 Größe')).toEqual(['café', '2026', 'größe']);
  });

  test('drops git trailer lines and the Claude Code footer', () => {
    const text = 'Real line here\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n'
      + 'Signed-off-by: Someone <someone@example.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    expect(normalizeTokens(text)).toEqual(['real', 'line', 'here']);
  });
});

describe('verbatim matching', () => {
  test(`a run of ${CHUNK_TOKENS} tokens from a personal source is held, with source and excerpt`, () => {
    const matches = checkOutgoing(out('As noted: lead with the conclusion and one example, and disengages from repetitive work today.'), sources);
    expect(matches).toEqual([
      {
        kind: 'verbatim',
        vault: 'personal',
        source: 'profile.md (vault context)',
        excerpt: 'lead with the conclusion and one example and disengages from repetitive work',
      },
    ]);
  });

  test('formatting changes do not defeat the match', () => {
    const reformatted = '> **LEAD WITH THE CONCLUSION** and one example,\n> and *disengages* from repetitive   work';
    expect(checkOutgoing(out(reformatted), sources)).toHaveLength(1);
  });

  test(`${CHUNK_TOKENS - 1} matching tokens are not enough`, () => {
    const eleven = 'with the conclusion and one example and disengages from repetitive work';
    expect(normalizeTokens(eleven)).toHaveLength(CHUNK_TOKENS - 1);
    expect(checkOutgoing(out(eleven), sources)).toEqual([]);
  });

  test('separate outgoing strings are not joined into one run', () => {
    expect(checkOutgoing(out('lead with the conclusion and one', 'example and disengages from repetitive work'), sources)).toEqual([]);
  });

  test('text already in the previous version is not reported again', () => {
    const quoted = 'lead with the conclusion and one example and disengages from repetitive work';
    expect(checkOutgoing(out(`${quoted}\nplus a new line`), sources, out(quoted))).toEqual([]);
  });

  test('one match per source, and at most a capped number overall', () => {
    const many: PersonalSource[] = Array.from({ length: MAX_VERBATIM_MATCHES + 2 }, (_, i) => ({
      vault: 'personal', slug: `n/${i}`, text: PROFILE,
    }));
    const matches = checkOutgoing(out(PROFILE), many);
    expect(matches).toHaveLength(MAX_VERBATIM_MATCHES);
  });

  describe('common boilerplate does not trip the check', () => {
    // Each fixture appears in both a personal note and the outgoing text.
    const fixtures: Record<string, string> = {
      'commit trailer': 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
      'Claude Code footer': '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'markdown checklist': '- [ ] Write tests\n- [ ] Update docs\n- [x] Open PR',
      'markdown table header': '| Param | Type | Notes |\n|---|---|---|',
      'issue template headings': '## Steps to reproduce\n\n## Expected behaviour\n\n## Actual behaviour\n\n## Environment',
      'acceptance criteria heading': '## Acceptance criteria\n- [ ] It works',
      'long issue template': '## Summary\n\n## Steps to reproduce\n\n## Expected behaviour\n\n## Actual behaviour\n\n'
        + '## Environment\n\n## Acceptance criteria\n- [ ] Tests added\n- [ ] Docs updated\n- [ ] Changelog entry',
      'install command': 'pnpm install --frozen-lockfile && pnpm test',
    };
    test.each(Object.entries(fixtures))('%s', (_name, text) => {
      const personal: PersonalSource[] = [{ vault: 'personal', slug: 'notes/x', text: `Intro.\n${text}\nOutro.` }];
      expect(checkOutgoing(out(`Something else.\n${text}\nMore.`), personal)).toEqual([]);
    });
  });

  describe('expected holds: public text that a personal note also contains', () => {
    // Personal project notes often copy repo text; a station write repeating it
    // is held like any other overlap and needs approval.
    const copies: Record<string, string> = {
      'plain bullet list': '- pnpm install --frozen-lockfile\n- pnpm typecheck\n- pnpm test\n- pnpm build\n- bump version in package json',
      'multi-row table': '| key | default | description |\n|---|---|---|\n| timeout_ms | 5000 | request timeout |\n| api_key_env | none | key variable |',
      'code block': '```bash\npnpm install --frozen-lockfile\npnpm -C server build\nnode server/dist/mcp-entry.js --help\n```',
    };
    test.each(Object.entries(copies))('%s', (_name, text) => {
      const personal: PersonalSource[] = [{ vault: 'personal', slug: 'projects/dossier', text: `Notes.\n\n${text}\n` }];
      expect(checkOutgoing(out(text), personal)).toHaveLength(1);
    });
  });

  test('a stock prose sentence of at least the chunk size is held, by design', () => {
    const stock = 'Thanks for the report, I will take a look at this as soon as I can.';
    const personal: PersonalSource[] = [{ vault: 'personal', slug: 'notes/replies', text: stock }];
    expect(checkOutgoing(out(stock), personal)).toHaveLength(1);
  });

  test('hard-wrapped prose still forms one run', () => {
    const wrapped = 'Ethan prefers to lead with the\nconclusion and one example, and\ndisengages from repetitive work.';
    expect(checkOutgoing(out(wrapped), sources)).toHaveLength(1);
  });

  test('runs cross list items, so a copied list of short facts is held', () => {
    const split = '- lead with the conclusion and one\n- example and disengages from repetitive work';
    expect(checkOutgoing(out(split), sources)).toHaveLength(1);
  });

  test('runs do not cross headings, task items or blank lines', () => {
    const rest = 'example and disengages from repetitive work';
    expect(checkOutgoing(out(`## lead with the conclusion and one\n${rest}`), sources)).toEqual([]);
    expect(checkOutgoing(out(`- [ ] lead with the conclusion and one\n${rest}`), sources)).toEqual([]);
    expect(checkOutgoing(out(`lead with the conclusion and one\n\n${rest}`), sources)).toEqual([]);
  });

  describe('a copied profile of short facts is held', () => {
    const profile = '# Profile\n\n- Partner: Jane Doe\n- Employer: Acme Corp, staff engineer\n- Salary: 140k base plus equity\n'
      + '- Health: type 1 diabetes, insulin pump\n- Address: 12 Elm Street, Springfield\n\n| SSN last4 | 1234 |';
    const personal: PersonalSource[] = [{ vault: 'personal', slug: 'profile', label: 'profile.md (vault context)', text: profile }];

    test('verbatim', () => {
      expect(checkOutgoing(out(profile), personal)).toHaveLength(1);
    });

    test('reflowed into one paragraph', () => {
      const prose = 'Partner Jane Doe, employer Acme Corp, staff engineer; salary 140k base plus equity; health type 1 diabetes.';
      expect(checkOutgoing(out(prose), personal)).toHaveLength(1);
    });
  });

  describe('boilerplate stripping cannot carry personal text', () => {
    test('a trailer-shaped line with a long "name" is checked', () => {
      const line = `Noted-by: ${QUOTE_TEXT} <x@y.z>`;
      expect(checkOutgoing(out(line), sources)).toHaveLength(1);
    });

    test('a line merely mentioning the footer is checked', () => {
      expect(checkOutgoing(out(`${QUOTE_TEXT} (Generated with Claude Code)`), sources)).toHaveLength(1);
    });
  });

  test('zero-width characters and soft hyphens inside words do not split them', () => {
    const hidden = 'le​ad with the con­clusion and one ex‍ample, and disengages from repetitive work';
    expect(checkOutgoing(out(hidden), sources)).toHaveLength(1);
  });
});

const QUOTE_TEXT = 'lead with the conclusion and one example, and disengages from repetitive work';

describe('link matching', () => {
  test.each([
    ['wiki-link', 'See [[finances/budget]] for numbers.'],
    ['wiki-link with heading and alias', 'See [[finances/budget#2026|the budget]].'],
    ['note:// URI', 'Details at note://finances%2Fbudget.'],
    ['bare path', 'Pulled from finances/budget earlier.'],
    ['path with .md', 'Pulled from finances/budget.md earlier.'],
    ['path ending a sentence', 'The numbers came from finances/budget.'],
  ])('%s to a personal note is held', (_name, text) => {
    expect(checkOutgoing(out(text), sources)).toEqual([{ kind: 'link', vault: 'personal', slug: 'finances/budget' }]);
  });

  test('a single-segment slug counts only as an explicit link', () => {
    expect(checkOutgoing(out('Update the profile section.'), sources)).toEqual([]);
    expect(checkOutgoing(out('Per [[profile]].'), sources)).toEqual([{ kind: 'link', vault: 'personal', slug: 'profile' }]);
    expect(checkOutgoing({ texts: [], links: ['profile'] }, sources)).toEqual([{ kind: 'link', vault: 'personal', slug: 'profile' }]);
  });

  test('a write path equal to a personal slug is its own kind of match, unless it was already the path', () => {
    expect(checkOutgoing({ texts: [], links: [], path: 'Finances/Budget' }, sources))
      .toEqual([{ kind: 'path', vault: 'personal', slug: 'finances/budget' }]);
    expect(checkOutgoing({ texts: [], links: [], path: 'finances/budget' }, sources, { texts: [], links: [], path: 'finances/budget' }))
      .toEqual([]);
  });

  test('slugs compare case-insensitively and report the personal spelling', () => {
    expect(checkOutgoing(out('See [[Finances/Budget]].'), sources)).toEqual([{ kind: 'link', vault: 'personal', slug: 'finances/budget' }]);
  });

  test('links to notes that are not personal pass', () => {
    expect(checkOutgoing(out('See [[projects/app-search]] and docs/setup.'), sources)).toEqual([]);
  });

  test('a link already in the previous version is not reported again', () => {
    expect(checkOutgoing(out('See [[finances/budget]] again.'), sources, out('See [[finances/budget]].'))).toEqual([]);
  });

  test('referencedSlugs extracts each form', () => {
    expect([...referencedSlugs('[[a/b|x]] note://c%2Fd e/f [[g]]')].sort()).toEqual(['a/b', 'c/d', 'e/f', 'g']);
  });
});

describe('helpers', () => {
  test('collectStrings walks nested objects and arrays, keys included', () => {
    expect(collectStrings({ a: 'x', b: ['y', { c: 'z' }], d: 1, e: null })).toEqual(['a', 'x', 'b', 'y', 'c', 'z', 'd', 'e']);
  });

  test('holdToken is stable for equal content and changes with the content or the secret', () => {
    const secret = Buffer.alloc(32, 1);
    expect(holdToken({ a: 'x' }, secret)).toBe(holdToken({ a: 'x' }, secret));
    expect(holdToken({ a: 'x' }, secret)).not.toBe(holdToken({ a: 'y' }, secret));
    expect(holdToken({ a: 'x' }, secret)).not.toBe(holdToken({ a: 'x' }, Buffer.alloc(32, 2)));
    expect(holdToken({ a: 'x' }, secret)).toMatch(/^hold-[0-9a-f]{16}$/);
  });
});
