import {
  buildVaultRegistry,
  resolveConfigSource,
  expandTilde,
  VaultConfigError,
  FALLBACK_VAULT_NAME,
} from '../vaultConfig.js';
import { resolveDefaultExcludeTags } from '../excludeTags.js';

const HOME = '/home/tester';
const DEFAULT_NOTES = '/opt/library/notes';
const existsAll = () => true;
const existsNone = () => false;

/** Convenience: build from YAML with paths assumed to exist. */
function build(yaml: string | undefined, overrides: Partial<Parameters<typeof buildVaultRegistry>[0]> = {}) {
  return buildVaultRegistry({
    rawConfig: yaml,
    defaultNotesDir: DEFAULT_NOTES,
    homeDir: HOME,
    pathExists: existsAll,
    ...overrides,
  });
}

describe('expandTilde', () => {
  test('bare ~ expands to the home dir', () => {
    expect(expandTilde('~', HOME)).toBe(HOME);
  });
  test('~/… expands against the home dir', () => {
    expect(expandTilde('~/vault', HOME)).toBe('/home/tester/vault');
  });
  test('absolute path is left untouched', () => {
    expect(expandTilde('/srv/vault', HOME)).toBe('/srv/vault');
  });
  test('a mid-string ~ is not expanded', () => {
    expect(expandTilde('/a/~/b', HOME)).toBe('/a/~/b');
  });
});

describe('buildVaultRegistry — NOTES_DIR fallback (no config file)', () => {
  test('regression: NOTES_DIR set → one default vault at that path, default exclude tags', () => {
    const reg = build(undefined, { notesDirEnv: '/srv/myvault' });
    expect(reg.vaults).toEqual([
      { name: FALLBACK_VAULT_NAME, path: '/srv/myvault', contextFile: 'profile.md' },
    ]);
    expect(reg.defaultVault).toBe(FALLBACK_VAULT_NAME);
    expect(reg.defaultExcludeTags).toEqual(['archived', 'historical']);
  });

  test('NOTES_DIR unset → falls back to defaultNotesDir', () => {
    const reg = build(undefined, { notesDirEnv: undefined });
    expect(reg.vaults[0].path).toBe(DEFAULT_NOTES);
  });

  test('NOTES_DIR empty string → falls back to defaultNotesDir', () => {
    const reg = build(undefined, { notesDirEnv: '' });
    expect(reg.vaults[0].path).toBe(DEFAULT_NOTES);
  });

  test('fallback does not consult pathExists (zero-migration boot)', () => {
    // Even with a predicate that rejects everything, the fallback must succeed.
    expect(() => build(undefined, { notesDirEnv: '/srv/myvault', pathExists: existsNone })).not.toThrow();
  });
});

describe('buildVaultRegistry — happy paths', () => {
  test('single vault, no default_vault → that vault is the default', () => {
    const reg = build('vaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultVault).toBe('personal');
    expect(reg.vaults).toEqual([
      { name: 'personal', path: '/home/tester/vault', contextFile: 'profile.md' },
    ]);
  });

  test('multi-vault: tilde expansion, contextFile default, sync carried, default honored', () => {
    const yaml = [
      'default_vault: personal',
      'vaults:',
      '  personal: {path: ~/vault}',
      '  dnd: {path: ~/dnd-vault, context_file: campaign.md}',
      '  work-shared: {path: ~/work/design-docs, sync: git-publication}',
    ].join('\n');
    const reg = build(yaml);
    expect(reg.defaultVault).toBe('personal');
    expect(reg.vaults).toEqual([
      { name: 'personal', path: '/home/tester/vault', contextFile: 'profile.md' },
      { name: 'dnd', path: '/home/tester/dnd-vault', contextFile: 'campaign.md' },
      { name: 'work-shared', path: '/home/tester/work/design-docs', sync: 'git-publication', contextFile: 'profile.md' },
    ]);
  });

  test('global exclude_tags override the default set', () => {
    const reg = build('exclude_tags: [draft, wip]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultExcludeTags).toEqual(['draft', 'wip']);
  });

  test('exclude_tags: [] opts out of the default exclude set', () => {
    const reg = build('exclude_tags: []\nvaults:\n  personal: {path: ~/vault}\n');
    expect(reg.defaultExcludeTags).toEqual([]);
  });

  test('absolute vault path is preserved as-is', () => {
    const reg = build('vaults:\n  personal: {path: /srv/vault}\n');
    expect(reg.vaults[0].path).toBe('/srv/vault');
  });
});

describe('buildVaultRegistry — validation (named fail-fast errors)', () => {
  const cases: Array<{ name: string; yaml: string; code: string; overrides?: object }> = [
    {
      name: 'more than one vault without default_vault → default_required',
      yaml: 'vaults:\n  a: {path: ~/a}\n  b: {path: ~/b}\n',
      code: 'default_required',
    },
    {
      name: 'default_vault names a missing vault → default_unknown',
      yaml: 'default_vault: nope\nvaults:\n  a: {path: ~/a}\n',
      code: 'default_unknown',
    },
    {
      name: 'default vault is git-publication → default_is_shared (leak guard)',
      yaml: 'default_vault: shared\nvaults:\n  shared: {path: ~/s, sync: git-publication}\n  local: {path: ~/l}\n',
      code: 'default_is_shared',
    },
    {
      name: 'uppercase vault name → bad_vault_name',
      yaml: 'vaults:\n  Personal: {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'vault name with a space → bad_vault_name',
      yaml: 'vaults:\n  "my vault": {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'vault name with a leading hyphen → bad_vault_name',
      yaml: 'vaults:\n  "-x": {path: ~/vault}\n',
      code: 'bad_vault_name',
    },
    {
      name: 'empty vaults mapping → no_vaults',
      yaml: 'vaults: {}\n',
      code: 'no_vaults',
    },
    {
      name: 'missing vaults key → no_vaults',
      yaml: 'default_vault: personal\n',
      code: 'no_vaults',
    },
    {
      name: 'vault missing a path → malformed',
      yaml: 'vaults:\n  personal: {sync: git-publication}\n',
      code: 'malformed',
    },
    {
      name: 'unknown sync value → malformed',
      yaml: 'vaults:\n  personal: {path: ~/v, sync: rsync}\n',
      code: 'malformed',
    },
    {
      name: 'non-list exclude_tags → malformed',
      yaml: 'exclude_tags: draft\nvaults:\n  personal: {path: ~/vault}\n',
      code: 'malformed',
    },
    {
      name: 'scalar (non-mapping) config → malformed',
      yaml: 'just a string\n',
      code: 'malformed',
    },
    {
      name: 'empty / comment-only config file → malformed (not silent fallback)',
      yaml: '# just a comment\n',
      code: 'malformed',
    },
    {
      name: 'vaults is a scalar (wrong type, not missing) → malformed',
      yaml: 'vaults: nope\n',
      code: 'malformed',
    },
    {
      name: 'vaults is a list (wrong type) → malformed',
      yaml: 'vaults:\n  - personal\n',
      code: 'malformed',
    },
  ];

  test.each(cases)('$name', ({ yaml, code, overrides }) => {
    let thrown: unknown;
    try {
      build(yaml, overrides);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe(code);
  });

  test('a vault path that does not exist → path_missing (+ directory message)', () => {
    let thrown: unknown;
    try {
      build('vaults:\n  personal: {path: ~/vault}\n', { pathExists: existsNone });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('path_missing');
    expect((thrown as VaultConfigError).message).toMatch(/not an existing directory/);
  });

  test('empty config file → malformed with a clear "config file is empty" message', () => {
    let thrown: unknown;
    try {
      build('# just a comment\n');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('malformed');
    expect((thrown as VaultConfigError).message).toMatch(/config file is empty/i);
  });

  test('invalid YAML → parse_error', () => {
    let thrown: unknown;
    try {
      build('vaults:\n  personal: {path: [unclosed\n');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConfigError);
    expect((thrown as VaultConfigError).code).toBe('parse_error');
  });
});

describe('exclude-tags resolution end-to-end (AC1: env wins over YAML)', () => {
  // Mirrors mcp-entry.ts: resolveDefaultExcludeTags(env, registry.defaultExcludeTags).
  test('DOSSIER_EXCLUDE_TAGS overrides the YAML exclude_tags', () => {
    const reg = build('exclude_tags: [archived, historical]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags('draft,wip', reg.defaultExcludeTags)).toEqual(['draft', 'wip']);
  });

  test('unset env → the YAML exclude_tags are used', () => {
    const reg = build('exclude_tags: [draft]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags(undefined, reg.defaultExcludeTags)).toEqual(['draft']);
  });

  test('empty-string env → [] opt-out beats the YAML exclude_tags', () => {
    const reg = build('exclude_tags: [archived]\nvaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags('', reg.defaultExcludeTags)).toEqual([]);
  });

  test('no YAML exclude_tags + unset env → the default exclude set', () => {
    const reg = build('vaults:\n  personal: {path: ~/vault}\n');
    expect(resolveDefaultExcludeTags(undefined, reg.defaultExcludeTags)).toEqual(['archived', 'historical']);
  });
});

describe('resolveConfigSource — resolution chain', () => {
  const join = (...parts: string[]) => parts.join('/');

  test('DOSSIER_CONFIG set and file exists → that file', () => {
    const src = resolveConfigSource(
      { DOSSIER_CONFIG: '/etc/dossier.yaml' },
      { homeDir: HOME, fileExists: existsAll, join },
    );
    expect(src).toEqual({ kind: 'file', path: '/etc/dossier.yaml' });
  });

  test('DOSSIER_CONFIG set but file missing → config_not_found', () => {
    expect(() =>
      resolveConfigSource({ DOSSIER_CONFIG: '/nope.yaml' }, { homeDir: HOME, fileExists: existsNone, join }),
    ).toThrow(VaultConfigError);
  });

  test('no DOSSIER_CONFIG, XDG default file exists → XDG path', () => {
    const src = resolveConfigSource(
      {},
      { homeDir: HOME, fileExists: (p) => p === '/home/tester/.config/dossier/config.yaml', join },
    );
    expect(src).toEqual({ kind: 'file', path: '/home/tester/.config/dossier/config.yaml' });
  });

  test('honors XDG_CONFIG_HOME when set', () => {
    const src = resolveConfigSource(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      { homeDir: HOME, fileExists: (p) => p === '/custom/xdg/dossier/config.yaml', join },
    );
    expect(src).toEqual({ kind: 'file', path: '/custom/xdg/dossier/config.yaml' });
  });

  test('nothing set and no XDG file → fallback', () => {
    const src = resolveConfigSource({}, { homeDir: HOME, fileExists: existsNone, join });
    expect(src).toEqual({ kind: 'fallback' });
  });
});
