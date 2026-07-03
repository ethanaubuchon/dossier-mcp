import { appendToSection } from '../sections.js';

// Helper: appendToSection returns a discriminated union; narrow to the ok body
// or fail loudly so type errors surface as test failures, not silent undefined.
function body(result: ReturnType<typeof appendToSection>): string {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  return result.body;
}

describe('appendToSection', () => {
  test('appends at the end of an existing section, before the next heading', () => {
    const input = '# Note\n\n## Status\n\nshaping\n\n## Notes\n\nfoo\n';
    const out = body(appendToSection(input, 'Status', '- shipped', false));
    expect(out).toBe('# Note\n\n## Status\n\nshaping\n\n- shipped\n\n## Notes\n\nfoo');
  });

  test('respects nested-heading boundary (appends after the subsection)', () => {
    const input = '## A\n\nintro\n\n### A.1\n\ndetail\n\n## B\n\nend\n';
    const out = body(appendToSection(input, 'A', '- more', false));
    // Boundary is `## B` (same level as A), so the bullet lands after A.1's content.
    expect(out).toBe('## A\n\nintro\n\n### A.1\n\ndetail\n\n- more\n\n## B\n\nend');
  });

  test('matches level-agnostically and uses the matched level for the boundary', () => {
    const input = '### Foo\n\nx\n\n#### Bar\n\ny\n\n## Top\n\nz\n';
    const out = body(appendToSection(input, 'Foo', '- add', false));
    // Foo is level 3; `## Top` (level 2 <= 3) is the boundary; Bar (level 4) is inside.
    expect(out).toBe('### Foo\n\nx\n\n#### Bar\n\ny\n\n- add\n\n## Top\n\nz');
  });

  test('ignores headings inside fenced code blocks', () => {
    const input = '## Real\n\ntext\n\n```md\n## Real\nfenced\n```\n';
    // The fenced `## Real` is neither matched (no ambiguity) nor treated as a
    // section boundary, so the section runs to EOF and the bullet lands after
    // the fence — which stays intact verbatim.
    const out = body(appendToSection(input, 'Real', '- x', false));
    expect(out).toBe('## Real\n\ntext\n\n```md\n## Real\nfenced\n```\n\n- x');
  });

  test('a heading that only appears inside a fence is treated as missing', () => {
    const input = 'intro\n\n```\n## Hidden\n```\n';
    const result = appendToSection(input, 'Hidden', '- x', false);
    expect(result).toEqual({ ok: false, reason: 'missing', headings: [] });
  });

  test('missing heading (create_if_missing=false) lists existing headings', () => {
    const input = '## Status\n\nshaping\n\n## Notes\n\nfoo\n';
    const result = appendToSection(input, 'Decisions', '- x', false);
    expect(result).toEqual({ ok: false, reason: 'missing', headings: ['Status', 'Notes'] });
  });

  test('missing heading with create_if_missing=true creates a section at EOF', () => {
    const input = '## Status\n\nshaping\n';
    const out = body(appendToSection(input, 'Decisions', '- chose X', true));
    expect(out).toBe('## Status\n\nshaping\n\n## Decisions\n\n- chose X');
  });

  test('create_if_missing on empty body produces just the new section', () => {
    const out = body(appendToSection('', 'Log', 'first entry', true));
    expect(out).toBe('## Log\n\nfirst entry');
  });

  test('ambiguous heading reports the match count', () => {
    const input = '## Foo\n\na\n\n## Foo\n\nb\n';
    const result = appendToSection(input, 'Foo', '- x', false);
    expect(result).toEqual({ ok: false, reason: 'ambiguous', count: 2 });
  });

  test('normalizes trailing blank lines to a single blank before the appended block', () => {
    const input = '## Status\n\nshaping\n\n\n\n## Notes\n\nfoo\n';
    const out = body(appendToSection(input, 'Status', '- shipped', false));
    expect(out).toBe('## Status\n\nshaping\n\n- shipped\n\n## Notes\n\nfoo');
  });

  test('appends to a section at EOF', () => {
    const input = '## Intro\n\nhi\n\n## Log\n\nfirst\n';
    const out = body(appendToSection(input, 'Log', 'second', false));
    expect(out).toBe('## Intro\n\nhi\n\n## Log\n\nfirst\n\nsecond');
  });

  test('handles an empty section (heading immediately followed by another heading)', () => {
    const input = '## Log\n## Next\n\nx\n';
    const out = body(appendToSection(input, 'Log', 'entry', false));
    expect(out).toBe('## Log\n\nentry\n\n## Next\n\nx');
  });

  test('appends multi-line content intact', () => {
    const input = '## Log\n\nfirst\n';
    const out = body(appendToSection(input, 'Log', '- a\n- b\n- c', false));
    expect(out).toBe('## Log\n\nfirst\n\n- a\n- b\n- c');
  });

  test('matches a heading with a trailing ATX closing sequence', () => {
    const input = '## Log ##\n\nfirst\n';
    const out = body(appendToSection(input, 'Log', 'second', false));
    expect(out).toBe('## Log ##\n\nfirst\n\nsecond');
  });

  test('does not strip a mid-text hash (e.g. "C# tips")', () => {
    const input = '## C# tips\n\nfirst\n';
    const out = body(appendToSection(input, 'C# tips', 'second', false));
    expect(out).toBe('## C# tips\n\nfirst\n\nsecond');
  });

  test('heading match is case-sensitive', () => {
    const input = '## Status\n\nshaping\n';
    const result = appendToSection(input, 'status', '- x', false);
    expect(result).toEqual({ ok: false, reason: 'missing', headings: ['Status'] });
  });
});
