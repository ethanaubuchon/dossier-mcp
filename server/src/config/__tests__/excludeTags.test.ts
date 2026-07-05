import { parseExcludeTagsEnv, resolveDefaultExcludeTags, DEFAULT_EXCLUDE_TAGS } from '../excludeTags.js';

describe('parseExcludeTagsEnv', () => {
  test('unset (undefined) → undefined, so the caller falls back to config', () => {
    expect(parseExcludeTagsEnv(undefined)).toBeUndefined();
  });

  test('explicit empty string → [] (opt-out, exclude nothing)', () => {
    expect(parseExcludeTagsEnv('')).toEqual([]);
  });

  test('whitespace-only string → [] (all tokens blank)', () => {
    expect(parseExcludeTagsEnv('  ')).toEqual([]);
  });

  test('comma-splits into a tag list', () => {
    expect(parseExcludeTagsEnv('archived,historical')).toEqual(['archived', 'historical']);
  });

  test('trims surrounding whitespace on each tag', () => {
    expect(parseExcludeTagsEnv(' archived , historical ')).toEqual(['archived', 'historical']);
  });

  test('drops empty tokens from stray/trailing commas', () => {
    expect(parseExcludeTagsEnv('archived,,historical,')).toEqual(['archived', 'historical']);
  });
});

describe('resolveDefaultExcludeTags (env-over-config resolution)', () => {
  const configDefault = ['archived', 'historical'];

  test('unset env → falls back to the config default', () => {
    expect(resolveDefaultExcludeTags(undefined, configDefault)).toEqual(['archived', 'historical']);
  });

  test('explicit empty string → [] beats the config default (per-vault opt-out)', () => {
    expect(resolveDefaultExcludeTags('', configDefault)).toEqual([]);
  });

  test('a non-empty env value replaces the config default', () => {
    expect(resolveDefaultExcludeTags('draft,wip', configDefault)).toEqual(['draft', 'wip']);
  });
});

describe('DEFAULT_EXCLUDE_TAGS', () => {
  test('ships archived + historical as the default exclude set', () => {
    expect(DEFAULT_EXCLUDE_TAGS).toEqual(['archived', 'historical']);
  });
});
