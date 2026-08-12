import { parseMatter, UnsupportedFrontmatterLanguageError } from '../parseMatter.js';

// gray-matter ships a `javascript` engine that runs the frontmatter block
// through eval(). Any fence that selects a non-YAML engine must be rejected
// before it reaches gray-matter, so note content can never execute code.
//
// The sentinel below is what an executed payload would set. Every rejection
// test asserts it stayed undefined — proving the block was never evaluated,
// not merely that parsing produced no usable data.
declare const globalThis: Record<string, unknown>;

const SENTINEL = '__parseMatterTestSentinel';
const payload = `module.exports = { title: (globalThis.${SENTINEL} = 'executed') }`;

beforeEach(() => {
  delete globalThis[SENTINEL];
});

afterEach(() => {
  delete globalThis[SENTINEL];
});

describe('parseMatter — non-YAML frontmatter engines', () => {
  test.each([['js'], ['javascript'], ['JS'], ['  js  '], ['coffee'], ['toml']])(
    'rejects a "---%s" fence without evaluating it',
    (language) => {
      const raw = `---${language}\n${payload}\n---\n\nbody\n`;

      expect(() => parseMatter(raw)).toThrow(UnsupportedFrontmatterLanguageError);
      expect(globalThis[SENTINEL]).toBeUndefined();
    },
  );

  test('the thrown error names the offending language', () => {
    expect(() => parseMatter(`---js\n${payload}\n---\n`)).toThrow(/js/);
  });
});

describe('parseMatter — supported input', () => {
  test('parses a plain YAML fence', () => {
    const raw = '---\ntitle: Hello\ntags:\n  - a\n---\n\nbody text\n';
    const parsed = parseMatter(raw);

    expect(parsed.data).toEqual({ title: 'Hello', tags: ['a'] });
    expect(parsed.content.trim()).toBe('body text');
  });

  test.each([['yaml'], ['yml']])('accepts an explicit "---%s" fence', (language) => {
    const parsed = parseMatter(`---${language}\ntitle: Hello\n---\n\nbody\n`);
    expect(parsed.data).toEqual({ title: 'Hello' });
  });

  test('handles content with no frontmatter at all', () => {
    const parsed = parseMatter('just a body, no fence\n');

    expect(parsed.data).toEqual({});
    expect(parsed.content.trim()).toBe('just a body, no fence');
  });

  test('does not treat a mid-document --- as a language fence', () => {
    const parsed = parseMatter('---\ntitle: Hello\n---\n\nbefore\n\n---\n\nafter\n');

    expect(parsed.data).toEqual({ title: 'Hello' });
    expect(parsed.content).toContain('after');
  });

  test('YAML tags that would construct arbitrary types do not execute', () => {
    // gray-matter parses YAML with safeLoad, so !!js/function is refused by the
    // schema. Asserted here so a future engine swap cannot silently regress it.
    const raw = "---\ntitle: !!js/function 'function () { globalThis." + SENTINEL + " = \"executed\" }'\n---\n\nbody\n";

    expect(() => parseMatter(raw)).toThrow();
    expect(globalThis[SENTINEL]).toBeUndefined();
  });
});
