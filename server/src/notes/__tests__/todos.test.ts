import { extractTodos } from '../todos.js';

describe('extractTodos', () => {
  test('returns empty array for content without todos', () => {
    expect(extractTodos('Just plain text.')).toEqual([]);
    expect(extractTodos('')).toEqual([]);
  });

  test('extracts a single unchecked todo', () => {
    const content = '- [ ] Buy milk';
    expect(extractTodos(content)).toEqual(['Buy milk']);
  });

  test('extracts multiple unchecked todos preserving order', () => {
    const content = '- [ ] First\n- [ ] Second\n- [ ] Third';
    expect(extractTodos(content)).toEqual(['First', 'Second', 'Third']);
  });

  test('skips checked todos (lowercase x)', () => {
    const content = '- [ ] Pending\n- [x] Done\n- [ ] Also pending';
    expect(extractTodos(content)).toEqual(['Pending', 'Also pending']);
  });

  test('skips checked todos (uppercase X)', () => {
    const content = '- [X] Done\n- [ ] Pending';
    expect(extractTodos(content)).toEqual(['Pending']);
  });

  test('recognizes star and plus list markers', () => {
    const content = '* [ ] star todo\n+ [ ] plus todo\n- [ ] dash todo';
    expect(extractTodos(content)).toEqual(['star todo', 'plus todo', 'dash todo']);
  });

  test('recognizes indented (nested) todos', () => {
    const content = '- [ ] Parent\n  - [ ] Sub-todo\n    - [ ] Deeper';
    expect(extractTodos(content)).toEqual(['Parent', 'Sub-todo', 'Deeper']);
  });

  test('preserves inline content (links, code spans, formatting)', () => {
    const content = '- [ ] Read [the docs](https://example.com) and run `npm test`';
    expect(extractTodos(content)).toEqual([
      'Read [the docs](https://example.com) and run `npm test`',
    ]);
  });

  test('ignores checkbox syntax inside fenced code blocks', () => {
    const content = [
      '- [ ] Real todo',
      '',
      '```',
      '- [ ] Not a real todo (inside code block)',
      '```',
      '',
      '- [ ] Another real todo',
    ].join('\n');
    expect(extractTodos(content)).toEqual(['Real todo', 'Another real todo']);
  });

  test('ignores fenced code blocks with language tag', () => {
    const content = [
      '- [ ] Real',
      '',
      '```markdown',
      '- [ ] Example syntax in docs',
      '```',
    ].join('\n');
    expect(extractTodos(content)).toEqual(['Real']);
  });

  test('does not treat malformed checkbox as todo', () => {
    expect(extractTodos('- [] missing space')).toEqual([]);
    expect(extractTodos('-[ ] missing space after dash')).toEqual([]);
    expect(extractTodos('- [  ] double space inside')).toEqual([]);
  });

  test('does not match plain bullets', () => {
    expect(extractTodos('- normal bullet')).toEqual([]);
    expect(extractTodos('* normal bullet')).toEqual([]);
  });

  test('trims trailing whitespace from todo text', () => {
    expect(extractTodos('- [ ] Trailing spaces here   ')).toEqual(['Trailing spaces here']);
  });
});
